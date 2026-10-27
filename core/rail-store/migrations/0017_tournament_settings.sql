-- R5.5: the user's settings per tournament (`TournamentSettings` in
-- web/src/lib/analysis/tournament.ts): the kind, the payouts in percent,
-- the field, the starting stack, players-left points. The ICM grading reads
-- them; local only (Q4's sync carries hands and statistics), as `chart_sets`.
--
-- Keyed as the web's `tournament_settings`: the site lower-cased (the
-- hand's `meta.siteId`) and the tournament id. Saving or deleting a row
-- deletes the stored analysis of that tournament's hands (found by
-- `hand_stats.tournament_id`, indexed below), so they are analysed again.

CREATE TABLE tournament_settings (
  site          TEXT    NOT NULL CHECK (length(site) BETWEEN 1 AND 64 AND site = lower(site)),
  tournament_id TEXT    NOT NULL CHECK (length(tournament_id) BETWEEN 1 AND 64),
  -- JSON object, at most 64 KiB
  settings      TEXT    NOT NULL,
  -- ms since the epoch
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (site, tournament_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX hand_stats_tournament_idx ON hand_stats (tournament_id) WHERE tournament_id IS NOT NULL;
