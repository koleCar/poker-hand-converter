-- rail-store schema, version 27 (docs/ANALYTICS.md Step 2): the Analytics
-- checker rows, the twin of the web's `analysis_checker_rows`
-- (`supabase/migrations/20271122090000_analytics_checker_rows.sql`).
--
-- - `analysis_checker_rows`: one row per (analysed hero decision, catalogue
--   rate it belongs to) - whether it took the rate's action class, the
--   reference's share of the class (NULL: not analysed), whether its best
--   option is in the class, the EV loss (0 without one), the size bucket
--   ('' preflop or no bet), the hand class ('' preflop), the spot
--   (`pot|role|hero|opponent`), multiway - with the hand's time, format,
--   seat and pot type for the filters. Derived in Rust
--   (`rail_stats::analytics_rows`) from the hand's PHF and its stored
--   decisions: when a hand's analysis is saved, and by the background
--   pass's backfill (`rail_store::checker`). Goes with the hand's analysis
--   (cascade).
-- - `hand_analysis.checker_version`: the membership version the hand's rows
--   were written at ('' never): a hand whose mark is not the build's
--   `MEMBERSHIP_VERSION` is the backfill's work. `checker_position`: the
--   hero's seat, for the readers' hand count under a seat filter.
--
-- Empty: the backfill fills it in the background, nothing is re-analysed.

ALTER TABLE hand_analysis ADD COLUMN checker_version TEXT NOT NULL DEFAULT '';
ALTER TABLE hand_analysis ADD COLUMN checker_position TEXT NOT NULL DEFAULT '';

CREATE INDEX hand_analysis_checker_idx ON hand_analysis (checker_version);

CREATE TABLE analysis_checker_rows (
  hand_key           TEXT    NOT NULL REFERENCES hand_analysis (hand_key) ON DELETE CASCADE,
  ord                INTEGER NOT NULL,
  stat               TEXT    NOT NULL,
  analysis_version   TEXT    NOT NULL,
  membership_version TEXT    NOT NULL,
  action_index       INTEGER NOT NULL,
  -- '' without a date
  played_at          TEXT    NOT NULL,
  game_format        TEXT    NOT NULL,
  hero_position      TEXT    NOT NULL,
  pot_type           TEXT    NOT NULL,
  taken              INTEGER NOT NULL CHECK (taken IN (0, 1)),
  ref_share          REAL,
  best_in            INTEGER CHECK (best_in IN (0, 1)),
  ev_loss_bb         REAL    NOT NULL,
  size               TEXT    NOT NULL,
  hand_class         TEXT    NOT NULL,
  spot               TEXT    NOT NULL,
  multiway           INTEGER NOT NULL CHECK (multiway IN (0, 1)),
  PRIMARY KEY (hand_key, ord, stat),
  CHECK ((ref_share IS NULL) = (best_in IS NULL))
) STRICT, WITHOUT ROWID;

-- The readers scan a version's rows; the examples read a stat by EV loss.
CREATE INDEX analysis_checker_rows_stat_idx
  ON analysis_checker_rows (analysis_version, stat, ev_loss_bb DESC);
