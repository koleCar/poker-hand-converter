-- rail-store schema, version 16 (docs/RAIL-PLAN.md R5.4): the hand analysis
-- in the app, and the user's own preflop charts.
--
-- - `hand_analysis` / `decision_analysis`: what the web keeps in its tables
--   of the same names (`supabase/migrations/20261228090000_analysis.sql`),
--   one row per analysed hand and one per hero decision, written by the
--   app's analysis runner (the web's library, `frontend/src/lib/analysis`,
--   run in a worker of the window over the hands here). Numbers are stored
--   rounded as the web's numeric columns round them (`rows.ts` in the app),
--   so a stored row reads back as the web's does. **One version per hand**:
--   a hand has at most one row, of the version it was last analysed at; the
--   runner analyses every hand without a row at the app's `ANALYSIS_VERSION`
--   (none, or an older one: a version bump re-analyses everything, newest
--   hands first) and replaces the row. The web keeps old versions until a
--   prune; the app has no reader of an old version, so it keeps none.
-- - `flop_library`: 1 when the hand was analysed with the flop library at
--   hand (A5b: the chunks are fetched from the web's public bucket and kept
--   on disk), 0 when it was not (offline): such a hand is graded exactly as
--   the web grades one whose chunks cannot be fetched (the heuristic), and
--   the runner analyses it again once the library can be reached, if it has
--   a flop decision.
-- - `analysis_leak_rows` and `chart_decisions`: the narrow rows the web
--   keeps by triggers for its top three (R5.2) and the own charts'
--   comparison (R5.3b), written here with the decisions (the keys computed
--   by the runner, `rows.ts`, as the web's SQL computes them; the hand's
--   time and format from `hands`), so the screens' sums read a narrow table
--   instead of every decision's facts.
-- - `chart_sets`: the user's own preflop charts (R5.3), local only (Q4: sync
--   carries hands and statistics, nothing else). `nodes` is the web's
--   `preflop_chart_sets.nodes` (each situation's actions as base64 of 169
--   bytes); the editor validates a set before it is saved, the store holds
--   the size and count limits.

CREATE TABLE hand_analysis (
  hand_key         TEXT    NOT NULL PRIMARY KEY REFERENCES hands (hand_key) ON DELETE CASCADE,
  analysis_version TEXT    NOT NULL CHECK (analysis_version GLOB 'analysis/[0-9]*'),
  status           TEXT    NOT NULL CHECK (status IN ('full', 'partial', 'not-analysed')),
  reason           TEXT,
  hero_seat        INTEGER,
  grade            TEXT    CHECK (grade IN ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  -- 0 no grade, perfect 1 ... blunder 5 (the web's `analysis_grade_rank`)
  grade_rank       INTEGER NOT NULL CHECK (grade_rank BETWEEN 0 AND 5),
  score            REAL,
  ev_loss_bb       REAL,
  ev_loss_pot      REAL,
  -- computed from the decisions on write, as `save_hand_analysis` does
  decisions        INTEGER NOT NULL,
  analysed         INTEGER NOT NULL,
  graded           INTEGER NOT NULL,
  flag_count       INTEGER NOT NULL,
  worst_flag       TEXT    CHECK (worst_flag IN ('note', 'inaccurate')),
  -- JSON array of strings
  approximations   TEXT    NOT NULL,
  pot_type         TEXT    NOT NULL,
  flop_library     INTEGER NOT NULL CHECK (flop_library IN (0, 1)),
  -- ms since the epoch
  analysed_at      INTEGER NOT NULL
) STRICT;

-- "Hands without a row at this version" walks the hands newest first and
-- looks each one up by its key; the counts read this.
CREATE INDEX hand_analysis_version_idx ON hand_analysis (analysis_version, flop_library);

CREATE TABLE decision_analysis (
  hand_key       TEXT    NOT NULL REFERENCES hand_analysis (hand_key) ON DELETE CASCADE,
  ord            INTEGER NOT NULL,
  action_index   INTEGER NOT NULL,
  street         TEXT    NOT NULL,
  action         TEXT    NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('analysed', 'not-analysed')),
  reason         TEXT,
  node           TEXT    NOT NULL,
  scenario       TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  grade          TEXT    CHECK (grade IN ('perfect', 'good', 'inaccurate', 'mistake', 'blunder')),
  grade_rank     INTEGER NOT NULL CHECK (grade_rank BETWEEN 0 AND 5),
  score          REAL,
  ev_loss_bb     REAL,
  ev_loss_pot    REAL,
  freq_diff      REAL,
  -- JSON (the web's jsonb columns, as the runner sent them)
  options        TEXT    NOT NULL,
  chosen         INTEGER,
  flags          TEXT    NOT NULL,
  worst_flag     TEXT    CHECK (worst_flag IN ('note', 'inaccurate')),
  approximations TEXT    NOT NULL,
  facing_bet     INTEGER NOT NULL CHECK (facing_bet IN (0, 1)),
  pot_bb         REAL,
  pot_odds       REAL,
  mdf            REAL,
  facts          TEXT    NOT NULL,
  -- the reference's best action (`analysis_best_action`), '' without options
  best           TEXT    NOT NULL,
  PRIMARY KEY (hand_key, ord)
) STRICT, WITHOUT ROWID;

-- The leak finder's rows (R5.2; the web's `analysis_leak_rows`): one narrow
-- row per graded decision, so the top three sums a million hands' decisions
-- without reading their facts. `spot_key` is `street|scenario|line|seat|
-- taken|best` and `chart_set` the chart set ('' off the charts), as the
-- web's `analysis_leak_spot_key` / `_chart_set` compute them; the hand's
-- time ('' without one), format, hero seat and pot type are the filters.
CREATE TABLE analysis_leak_rows (
  hand_key         TEXT    NOT NULL REFERENCES hand_analysis (hand_key) ON DELETE CASCADE,
  ord              INTEGER NOT NULL,
  analysis_version TEXT    NOT NULL,
  played_at        TEXT    NOT NULL,
  game_format      TEXT    NOT NULL,
  hero_position    TEXT    NOT NULL,
  pot_type         TEXT    NOT NULL,
  spot_key         TEXT    NOT NULL,
  chart_set        TEXT    NOT NULL,
  grade            TEXT    NOT NULL,
  score            REAL,
  ev_loss_bb       REAL    NOT NULL,
  ev_loss_pot      REAL    NOT NULL,
  action_index     INTEGER NOT NULL,
  PRIMARY KEY (hand_key, ord)
) STRICT, WITHOUT ROWID;

CREATE INDEX analysis_leak_rows_time_idx ON analysis_leak_rows (analysis_version, played_at);

-- The own charts' rows (R5.3b; the web's `preflop_decision_rows`): one
-- narrow row per preflop decision graded on the shipped tree, filed as
-- `preflop_decision_fields` files it - the situation key ('' when the
-- vocabulary does not name the line), the shipped set's table, the class
-- index 0-168, the action as a chart names it (`allin` for an all-in raise,
-- `raise` for a bet), the effective stack in 10 bb steps (-1 unknown) - with
-- the hand's time and format.
CREATE TABLE chart_decisions (
  hand_key         TEXT    NOT NULL REFERENCES hand_analysis (hand_key) ON DELETE CASCADE,
  ord              INTEGER NOT NULL,
  analysis_version TEXT    NOT NULL,
  played_at        TEXT    NOT NULL,
  game_format      TEXT    NOT NULL,
  table_size       INTEGER NOT NULL CHECK (table_size IN (2, 6, 9)),
  depth_band       INTEGER NOT NULL,
  chart_key        TEXT    NOT NULL,
  hand_class       INTEGER NOT NULL CHECK (hand_class BETWEEN 0 AND 168),
  action           TEXT    NOT NULL CHECK (action IN ('fold', 'check', 'call', 'raise', 'allin')),
  scenario         TEXT    NOT NULL,
  position         TEXT    NOT NULL,
  ev_loss_bb       REAL,
  action_index     INTEGER NOT NULL,
  PRIMARY KEY (hand_key, ord)
) STRICT, WITHOUT ROWID;

CREATE INDEX chart_decisions_time_idx ON chart_decisions (analysis_version, played_at);

CREATE TABLE chart_sets (
  id             TEXT    NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  name           TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  game_format    TEXT    NOT NULL CHECK (game_format IN ('cash', 'tournament')),
  table_size     INTEGER NOT NULL CHECK (table_size IN (2, 6, 9)),
  stack_min_bb   INTEGER NOT NULL CHECK (stack_min_bb BETWEEN 1 AND 1000),
  stack_max_bb   INTEGER NOT NULL CHECK (stack_max_bb BETWEEN stack_min_bb AND 1000),
  format_version INTEGER NOT NULL,
  -- JSON object: situation key -> { raise?, call?, allin?, raiseBb? }
  nodes          TEXT    NOT NULL CHECK (length(nodes) <= 409600),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;
